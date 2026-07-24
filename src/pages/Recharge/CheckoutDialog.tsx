import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, RefreshCw, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  BillingCheckout,
  BillingPaymentMethod,
  BillingPaymentStatus,
} from '@shared/billing';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  durationParts,
  formatCurrency,
  formatDateTime,
  formatNumber,
  paymentStatusTone,
  renderQrSvgMarkup,
  resolvePaymentMethodLabel,
} from './recharge-utils';

export type RechargeCheckout = BillingCheckout & {
  createdAt: number;
  lastCheckedAt: number;
  lastStatusError: string;
};

type CheckoutDialogProps = {
  checkout: RechargeCheckout | null;
  open: boolean;
  status: BillingPaymentStatus;
  checking: boolean;
  statusUnavailable: boolean;
  paymentMethods: BillingPaymentMethod[];
  onOpenChange: (open: boolean) => void;
  onCheckStatus: () => void;
  onOpenExternal: () => void;
  onReset: () => void;
};

export function CheckoutDialog({
  checkout,
  open,
  status,
  checking,
  statusUnavailable,
  paymentMethods,
  onOpenChange,
  onCheckStatus,
  onOpenExternal,
  onReset,
}: CheckoutDialogProps) {
  const { t, i18n } = useTranslation('recharge');
  const [now, setNow] = useState(0);
  const qrCode = checkout?.qrCode ?? '';
  const qrMarkup = useMemo(() => {
    if (!qrCode) return '';
    try {
      return renderQrSvgMarkup(qrCode);
    } catch {
      return '';
    }
  }, [qrCode]);

  useEffect(() => {
    if (!open || status !== 'pending') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, status, checkout?.tradeNo]);

  if (!checkout) return null;

  const terminal = status !== 'pending';
  const methodLabel = resolvePaymentMethodLabel(
    checkout.paymentMethod,
    '',
    paymentMethods,
    {
      alipay: t('methods.alipay'),
      wxpay: t('methods.wxpay'),
    },
  );
  const effectiveNow = Math.max(now, checkout.lastCheckedAt, checkout.createdAt);
  const waiting = durationParts(checkout.createdAt, effectiveNow);
  const waitingLabel = waiting.minutes > 0
    ? t('checkout.durationMinutes', waiting)
    : t('checkout.durationSeconds', waiting);
  const delayed = status === 'pending' && effectiveNow - checkout.createdAt > 120_000;
  const guidance = status === 'success'
    ? { title: t('checkout.success'), subtitle: '' }
    : status === 'failed'
      ? { title: t('checkout.guidance.failedTitle'), subtitle: t('checkout.guidance.failedSubtitle') }
      : status === 'cancelled'
        ? { title: t('checkout.guidance.cancelledTitle'), subtitle: t('checkout.guidance.cancelledSubtitle') }
        : status === 'expired'
          ? { title: t('checkout.guidance.expiredTitle'), subtitle: t('checkout.guidance.expiredSubtitle') }
          : statusUnavailable
            ? { title: t('checkout.guidance.unavailableTitle'), subtitle: t('checkout.guidance.unavailableSubtitle') }
            : delayed
              ? { title: t('checkout.guidance.delayedTitle'), subtitle: t('checkout.guidance.delayedSubtitle') }
              : { title: t('checkout.guidance.pendingTitle'), subtitle: t('checkout.guidance.pendingSubtitle') };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-3xl overflow-hidden rounded-lg border border-black/10 bg-surface-modal p-0 shadow-2xl dark:border-white/10">
        <header className="flex items-start justify-between gap-4 border-b border-black/10 px-6 py-5 dark:border-white/10">
          <div className="min-w-0">
            <DialogTitle className="font-serif text-xl font-normal tracking-tight text-foreground">
              {t('checkout.title')}
            </DialogTitle>
            <DialogDescription className="mt-1 truncate text-sm text-muted-foreground">
              {t('checkout.description', { tradeNo: checkout.tradeNo })}
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label={t('checkout.close')}
            title={t('checkout.close')}
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </header>

        <div className="grid max-h-[78vh] overflow-y-auto md:grid-cols-[300px_1fr]">
          <div className="border-b border-black/10 p-6 dark:border-white/10 md:border-b-0 md:border-r">
            {status === 'success' ? (
              <div className="flex min-h-64 flex-col items-center justify-center text-center">
                <CheckCircle2 className="h-12 w-12 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                <p className="mt-4 text-base font-medium text-foreground">{t('checkout.success')}</p>
              </div>
            ) : (
              <>
                <div className="mx-auto aspect-square w-full max-w-64 overflow-hidden rounded-md border border-black/10 bg-white p-3 dark:border-white/10">
                  {qrMarkup ? (
                    <div
                      className="h-full w-full [&_svg]:h-full [&_svg]:w-full"
                      dangerouslySetInnerHTML={{ __html: qrMarkup }}
                    />
                  ) : checkout.qrImageUrl ? (
                    <img
                      src={checkout.qrImageUrl}
                      alt={t('checkout.scan', { method: methodLabel })}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
                      {t('checkout.noQr')}
                    </div>
                  )}
                </div>
                <p className="mt-4 text-center text-sm text-muted-foreground">
                  {qrMarkup || checkout.qrImageUrl
                    ? t('checkout.scan', { method: methodLabel })
                    : t('checkout.returnToCheck')}
                </p>
              </>
            )}
          </div>

          <div className="p-6">
            <p className={cn(
              'inline-flex rounded-full bg-black/5 px-3 py-1 text-xs font-medium dark:bg-white/10',
              paymentStatusTone(status),
            )}
            >
              {t(`checkout.${status}`)}
            </p>
            <h3 className="mt-4 text-xl font-semibold text-foreground">{guidance.title}</h3>
            {guidance.subtitle && (
              <p className="mt-2 text-sm text-muted-foreground">{guidance.subtitle}</p>
            )}

            <dl className="mt-6 space-y-3 text-sm">
              <div className="flex justify-between gap-4 border-b border-black/10 pb-2 dark:border-white/10">
                <dt className="text-muted-foreground">{t('amount')}</dt>
                <dd className="font-medium text-foreground">
                  {formatCurrency(checkout.amountYuan, i18n.language)}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-black/10 pb-2 dark:border-white/10">
                <dt className="text-muted-foreground">{t('estimated')}</dt>
                <dd className="font-medium text-foreground">
                  {formatNumber(checkout.creditQuota, i18n.language, 0)} {t('balanceUnit')}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-black/10 pb-2 dark:border-white/10">
                <dt className="text-muted-foreground">{t('checkout.orderNumber')}</dt>
                <dd className="max-w-56 break-all text-right font-mono text-xs text-foreground">{checkout.tradeNo}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-black/10 pb-2 dark:border-white/10">
                <dt className="text-muted-foreground">{t('checkout.createdAt')}</dt>
                <dd className="text-right font-medium text-foreground">
                  {formatDateTime(checkout.createdAt, i18n.language)}
                </dd>
              </div>
              {status === 'pending' && (
                <div className="flex justify-between gap-4 border-b border-black/10 pb-2 dark:border-white/10">
                  <dt className="text-muted-foreground">{t('checkout.waiting')}</dt>
                  <dd className="text-right font-medium text-foreground">{waitingLabel}</dd>
                </div>
              )}
              {checkout.lastCheckedAt > 0 && (
                <div className="flex justify-between gap-4 border-b border-black/10 pb-2 dark:border-white/10">
                  <dt className="text-muted-foreground">{t('checkout.lastChecked')}</dt>
                  <dd className="text-right font-medium text-foreground">
                    {formatDateTime(checkout.lastCheckedAt, i18n.language)}
                  </dd>
                </div>
              )}
            </dl>

            {checkout.lastStatusError && (
              <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                {checkout.lastStatusError}
              </div>
            )}

            <div className="mt-6 flex flex-wrap justify-end gap-2">
              {checkout.checkoutUrl && status === 'pending' && (
                <Button type="button" variant="outline" onClick={onOpenExternal}>
                  <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('checkout.openExternal')}
                </Button>
              )}
              {!terminal && (
                <Button type="button" variant="outline" onClick={onCheckStatus} disabled={checking}>
                  {checking ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                  )}
                  {checking ? t('checkout.checking') : t('checkout.check')}
                </Button>
              )}
              {status !== 'success' && (
                <Button type="button" variant="outline" onClick={onReset}>
                  <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('checkout.cancelOrder')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
