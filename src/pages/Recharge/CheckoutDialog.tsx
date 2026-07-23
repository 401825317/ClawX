import { useMemo } from 'react';
import { CheckCircle2, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BillingCheckout, BillingPaymentStatus } from '@shared/billing';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  formatCurrency,
  formatNumber,
  paymentStatusTone,
  renderQrSvgMarkup,
} from './recharge-utils';

type CheckoutDialogProps = {
  checkout: BillingCheckout | null;
  open: boolean;
  status: BillingPaymentStatus;
  checking: boolean;
  statusUnavailable: boolean;
  onOpenChange: (open: boolean) => void;
  onCheckStatus: () => void;
  onOpenExternal: () => void;
};

export function CheckoutDialog({
  checkout,
  open,
  status,
  checking,
  statusUnavailable,
  onOpenChange,
  onCheckStatus,
  onOpenExternal,
}: CheckoutDialogProps) {
  const { t, i18n } = useTranslation('recharge');
  const qrCode = checkout?.qrCode ?? '';
  const qrMarkup = useMemo(() => {
    if (!qrCode) return '';
    try {
      return renderQrSvgMarkup(qrCode);
    } catch {
      return '';
    }
  }, [qrCode]);

  if (!checkout) return null;

  const terminal = status !== 'pending';
  const methodLabel = checkout.paymentMethod || t('paymentMethod');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-lg border border-black/10 bg-surface-modal p-0 shadow-2xl dark:border-white/10">
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

        <div className="max-h-[75vh] overflow-y-auto px-6 py-6">
          {status === 'success' ? (
            <div className="flex min-h-64 flex-col items-center justify-center text-center">
              <CheckCircle2 className="h-12 w-12 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              <p className="mt-4 text-base font-medium text-foreground">{t('checkout.success')}</p>
            </div>
          ) : (
            <>
              <div className="mx-auto aspect-square w-56 overflow-hidden rounded-md border border-black/10 bg-white p-3 dark:border-white/10">
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
                {t('checkout.scan', { method: methodLabel })}
              </p>
            </>
          )}

          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-black/10 pt-5 text-sm dark:border-white/10">
            <div>
              <dt className="text-muted-foreground">{t('amount')}</dt>
              <dd className="mt-1 font-medium text-foreground">
                {formatCurrency(checkout.amountYuan, i18n.language)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('estimated')}</dt>
              <dd className="mt-1 font-medium text-foreground">
                {formatNumber(checkout.creditQuota, i18n.language, 0)} {t('balanceUnit')}
              </dd>
            </div>
          </dl>

          {status !== 'success' && (
            <div className="mt-5 border-t border-black/10 pt-4 dark:border-white/10">
              <p className={cn('text-sm font-medium', paymentStatusTone(status))}>
                {t(`checkout.${status}`)}
              </p>
              {statusUnavailable && status === 'pending' && (
                <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
                  {t('checkout.statusUnavailable')}
                </p>
              )}
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
              <Button type="button" onClick={onCheckStatus} disabled={checking}>
                {checking ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                {checking ? t('checkout.checking') : t('checkout.check')}
              </Button>
            )}
            {terminal && (
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t('checkout.close')}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
