import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CreditCard, History, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type {
  BillingCheckout,
  BillingErrorCode,
  BillingOrderHistory,
  BillingPaymentStatus,
  BillingOverview,
} from '@shared/billing';
import {
  UCLAW_BILLING_HISTORY_PAGE_SIZE,
  UCLAW_BILLING_ORDER_STATUS_POLL_INTERVAL_MS,
} from '@shared/junfeiai-endpoints';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { hostApi } from '@/lib/host-api';
import { cn } from '@/lib/utils';
import { CheckoutDialog } from './CheckoutDialog';
import { OrderHistoryDialog } from './OrderHistoryDialog';
import {
  formatNumber,
  normalizeAmountInput,
  parseAmountFen,
  type RechargeErrorCode,
} from './recharge-utils';

const EMPTY_HISTORY: BillingOrderHistory = {
  page: 1,
  pageSize: UCLAW_BILLING_HISTORY_PAGE_SIZE,
  total: 0,
  items: [],
};

type StatusSyncResult = BillingPaymentStatus | 'stale';

export function Recharge() {
  const { t, i18n } = useTranslation('recharge');
  const [overview, setOverview] = useState<BillingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<RechargeErrorCode | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [amountYuan, setAmountYuan] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checkout, setCheckout] = useState<BillingCheckout | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [payStatus, setPayStatus] = useState<BillingPaymentStatus>('pending');
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<BillingOrderHistory>(EMPTY_HISTORY);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const pollTimerRef = useRef<number | null>(null);
  const activeTradeNoRef = useRef('');
  const statusRequestRef = useRef<{
    tradeNo: string;
    promise: Promise<StatusSyncResult>;
  } | null>(null);

  const errorText = useCallback((code: RechargeErrorCode | BillingErrorCode) => (
    t(`errors.${code}`)
  ), [t]);

  const availableProducts = useMemo(
    () => (overview?.products ?? []).filter(
      (product) => product.enabled && (product.stock === null || product.stock > 0),
    ),
    [overview?.products],
  );
  const selectedProduct = availableProducts.find((product) => product.id === selectedProductId) ?? null;
  const amountFen = parseAmountFen(amountYuan);
  const quotaPerYuan = (overview?.creditUsdPerCny ?? 0) * (overview?.quotaPerUnit ?? 0);
  const estimatedQuota = amountFen > 0 ? (amountFen / 100) * quotaPerYuan : 0;
  const paymentConfigured = Boolean(
    overview?.onlineTopupEnabled
    && availableProducts.length > 0
    && overview.paymentMethods.length > 0,
  );

  const clearPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  /** Refresh balance and server-owned recharge configuration. */
  const loadOverview = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setErrorCode(null);
    try {
      const result = await hostApi.billing.overview();
      if (!result.success) {
        setErrorCode(result.errorCode);
        return false;
      }

      const next = result.data;
      const nextProducts = next.products.filter(
        (product) => product.enabled && (product.stock === null || product.stock > 0),
      );
      setOverview(next);
      setSelectedProductId((current) => (
        nextProducts.some((product) => product.id === current) ? current : nextProducts[0]?.id ?? null
      ));
      setPaymentMethod((current) => (
        next.paymentMethods.some((method) => method.type === current)
          ? current
          : next.paymentMethods.find((method) => method.type === 'alipay')?.type
            ?? next.paymentMethods[0]?.type
            ?? ''
      ));
      if (!next.onlineTopupEnabled || nextProducts.length === 0 || next.paymentMethods.length === 0) {
        setErrorCode('configuration');
      }
      return true;
    } catch {
      setErrorCode('request_failed');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  /** Load a bounded order-history page only while its dialog is requested. */
  const loadHistory = useCallback(async (page: number) => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const result = await hostApi.billing.history({
        page,
        pageSize: UCLAW_BILLING_HISTORY_PAGE_SIZE,
      });
      if (!result.success) {
        setHistoryError(errorText(result.errorCode));
        return;
      }
      setHistory(result.data);
    } catch {
      setHistoryError(errorText('request_failed'));
    } finally {
      setHistoryLoading(false);
    }
  }, [errorText]);

  /** Synchronize one order status with stale-order and single-flight protection. */
  const syncOrderStatus = useCallback((tradeNo: string): Promise<StatusSyncResult> => {
    const existing = statusRequestRef.current;
    if (existing?.tradeNo === tradeNo) return existing.promise;

    const request = (async (): Promise<StatusSyncResult> => {
      try {
        const result = await hostApi.billing.orderStatus({ tradeNo });
        if (activeTradeNoRef.current !== tradeNo) return 'stale';
        if (!result.success) {
          setStatusUnavailable(true);
          return 'pending';
        }

        const nextStatus = result.data.status;
        setStatusUnavailable(false);
        setPayStatus(nextStatus);
        setCheckout((current) => current?.tradeNo === tradeNo
          ? { ...current, status: nextStatus, creditQuota: result.data.creditQuota || current.creditQuota }
          : current);
        if (nextStatus !== 'pending') {
          clearPolling();
        }
        if (nextStatus === 'success') {
          await loadOverview();
          toast.success(t('checkout.success'));
        }
        return nextStatus;
      } catch {
        if (activeTradeNoRef.current === tradeNo) setStatusUnavailable(true);
        return activeTradeNoRef.current === tradeNo ? 'pending' : 'stale';
      }
    })();

    statusRequestRef.current = { tradeNo, promise: request };
    void request.finally(() => {
      if (statusRequestRef.current?.promise === request) statusRequestRef.current = null;
    });
    return request;
  }, [clearPolling, loadOverview, t]);

  /** Poll serially so a slow status request can never overlap the next interval. */
  const startPolling = useCallback((tradeNo: string) => {
    clearPolling();
    const poll = async () => {
      if (activeTradeNoRef.current !== tradeNo) return;
      const status = await syncOrderStatus(tradeNo);
      if (activeTradeNoRef.current !== tradeNo || status !== 'pending') return;
      pollTimerRef.current = window.setTimeout(poll, UCLAW_BILLING_ORDER_STATUS_POLL_INTERVAL_MS);
    };
    pollTimerRef.current = window.setTimeout(poll, UCLAW_BILLING_ORDER_STATUS_POLL_INTERVAL_MS);
  }, [clearPolling, syncOrderStatus]);

  useEffect(() => {
    void loadOverview();
    return () => {
      activeTradeNoRef.current = '';
      clearPolling();
    };
  }, [clearPolling, loadOverview]);

  const handleSubmit = async () => {
    if (submitting || checkout || !paymentConfigured || !selectedProduct || !paymentMethod) return;
    if (amountFen <= 0) {
      setErrorCode('invalid_amount');
      return;
    }

    setSubmitting(true);
    setErrorCode(null);
    try {
      const result = await hostApi.billing.createOrder({
        amountFen,
        paymentMethod,
        productId: selectedProduct.id,
      });
      if (!result.success) {
        setErrorCode(result.errorCode);
        return;
      }
      if (result.data.status === 'success') {
        await loadOverview();
        toast.success(t('checkout.success'));
        return;
      }

      activeTradeNoRef.current = result.data.tradeNo;
      setCheckout(result.data);
      setPayStatus(result.data.status);
      setStatusUnavailable(false);
      setCheckoutOpen(true);
      if (result.data.status === 'pending') startPolling(result.data.tradeNo);
    } catch {
      setErrorCode('request_failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCheckStatus = async () => {
    if (!checkout?.tradeNo || checkingPayment) return;
    setCheckingPayment(true);
    try {
      await syncOrderStatus(checkout.tradeNo);
    } finally {
      setCheckingPayment(false);
    }
  };

  const handleCheckoutOpenChange = (open: boolean) => {
    setCheckoutOpen(open);
    if (open) return;
    activeTradeNoRef.current = '';
    clearPolling();
    setCheckout(null);
    setPayStatus('pending');
    setStatusUnavailable(false);
  };

  const handleOpenExternal = async () => {
    const url = checkout?.checkoutUrl;
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported payment URL');
      await hostApi.shell.openExternal(parsed.toString());
    } catch {
      toast.error(errorText('request_failed'));
    }
  };

  const handleHistoryOpen = () => {
    setHistoryOpen(true);
    void loadHistory(1);
  };

  const formDisabled = submitting || loading || !paymentConfigured || !selectedProduct || !paymentMethod || Boolean(checkout);

  return (
    <div data-testid="recharge-page" className="h-full overflow-y-auto bg-background">
      <main className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-8 lg:px-10">
        <header className="flex items-center justify-between gap-4">
          <h1 className="font-serif text-3xl font-normal tracking-tight text-foreground">
            {t('title')}
          </h1>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('history')}
              title={t('history')}
              onClick={handleHistoryOpen}
            >
              <History className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('refresh')}
              title={t('refresh')}
              disabled={loading}
              onClick={() => void loadOverview()}
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden="true" />
            </Button>
          </div>
        </header>

        {loading && !overview ? (
          <div className="flex min-h-96 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            {t('loading')}
          </div>
        ) : !overview ? (
          <div className="flex min-h-96 flex-col items-center justify-center text-center">
            <AlertCircle className="h-8 w-8 text-red-700 dark:text-red-400" aria-hidden="true" />
            <p className="mt-3 text-sm text-red-700 dark:text-red-400">
              {errorText(errorCode ?? 'request_failed')}
            </p>
            <Button type="button" variant="outline" className="mt-4" onClick={() => void loadOverview()}>
              {t('retry')}
            </Button>
          </div>
        ) : (
          <>
            <section className="mt-7 border-y border-black/10 py-6 dark:border-white/10">
              <p className="text-sm text-muted-foreground">{t('balance')}</p>
              <div className="mt-2 flex flex-wrap items-end gap-x-3 gap-y-1">
                <strong className="text-4xl font-semibold text-foreground">
                  {formatNumber(overview.balance, i18n.language, 0)}
                </strong>
                <span className="pb-1 text-sm text-muted-foreground">{t('balanceUnit')}</span>
              </div>
            </section>

            {errorCode && (
              <div className="mt-5 flex items-center gap-2 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {errorText(errorCode)}
              </div>
            )}

            <section className="border-b border-black/10 py-7 dark:border-white/10">
              <h2 className="text-sm font-medium text-foreground">{t('product')}</h2>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {overview.products.map((product) => {
                  const unavailable = !product.enabled || product.stock === 0;
                  const selected = product.id === selectedProductId;
                  return (
                    <button
                      key={product.id}
                      type="button"
                      aria-pressed={selected}
                      disabled={unavailable || submitting || Boolean(checkout)}
                      onClick={() => setSelectedProductId(product.id)}
                      className={cn(
                        'min-h-20 rounded-lg border px-4 py-3 text-left transition-colors',
                        selected
                          ? 'border-foreground/40 bg-black/5 dark:bg-white/10'
                          : 'border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5',
                        unavailable && 'cursor-not-allowed opacity-50',
                      )}
                    >
                      <span className="block text-sm font-medium text-foreground">{product.name}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {unavailable ? t('soldOut') : product.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="grid gap-7 border-b border-black/10 py-7 dark:border-white/10 md:grid-cols-2">
              <div>
                <label htmlFor="recharge-amount" className="text-sm font-medium text-foreground">
                  {t('amount')}
                </label>
                <div className="relative mt-3">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">¥</span>
                  <Input
                    id="recharge-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    value={amountYuan}
                    placeholder={t('amountPlaceholder')}
                    disabled={formDisabled}
                    onChange={(event) => {
                      setAmountYuan(normalizeAmountInput(event.target.value));
                      if (errorCode === 'invalid_amount') setErrorCode(null);
                    }}
                    className="h-11 bg-surface-input pl-8 text-base"
                  />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('rate', { quota: formatNumber(quotaPerYuan, i18n.language, 0) })}
                </p>
              </div>

              <div>
                <p className="text-sm font-medium text-foreground">{t('estimated')}</p>
                <p className="mt-3 text-2xl font-semibold text-foreground">
                  {formatNumber(estimatedQuota, i18n.language, 0)}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">{t('balanceUnit')}</span>
                </p>
              </div>
            </section>

            <section className="py-7">
              <h2 className="text-sm font-medium text-foreground">{t('paymentMethod')}</h2>
              <div className="mt-3 inline-flex max-w-full flex-wrap rounded-lg bg-surface-input p-1">
                {overview.paymentMethods.map((method) => (
                  <button
                    key={method.type}
                    type="button"
                    aria-pressed={paymentMethod === method.type}
                    disabled={submitting || Boolean(checkout)}
                    onClick={() => setPaymentMethod(method.type)}
                    className={cn(
                      'min-w-24 rounded-md px-4 py-2 text-sm transition-colors',
                      paymentMethod === method.type
                        ? 'bg-surface-modal font-medium text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {method.name}
                  </button>
                ))}
              </div>

              <div className="mt-7 flex justify-end">
                <Button type="button" size="lg" disabled={formDisabled} onClick={() => void handleSubmit()}>
                  {submitting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <CreditCard className="mr-2 h-4 w-4" aria-hidden="true" />
                  )}
                  {submitting ? t('submitting') : t('submit')}
                </Button>
              </div>
            </section>
          </>
        )}
      </main>

      <CheckoutDialog
        checkout={checkout}
        open={checkoutOpen}
        status={payStatus}
        checking={checkingPayment}
        statusUnavailable={statusUnavailable}
        onOpenChange={handleCheckoutOpenChange}
        onCheckStatus={() => void handleCheckStatus()}
        onOpenExternal={() => void handleOpenExternal()}
      />
      <OrderHistoryDialog
        open={historyOpen}
        history={history}
        loading={historyLoading}
        error={historyError}
        onOpenChange={setHistoryOpen}
        onPageChange={(page) => void loadHistory(page)}
      />
    </div>
  );
}

export default Recharge;
