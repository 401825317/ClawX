import { ChevronLeft, ChevronRight, Loader2, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BillingOrderHistory, BillingPaymentMethod } from '@shared/billing';
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
  formatDateTime,
  formatNumber,
  paymentStatusTone,
  resolvePaymentMethodLabel,
} from './recharge-utils';

type OrderHistoryDialogProps = {
  open: boolean;
  history: BillingOrderHistory;
  loading: boolean;
  error: string;
  paymentMethods: BillingPaymentMethod[];
  onOpenChange: (open: boolean) => void;
  onPageChange: (page: number) => void;
  onRefresh: () => void;
};

export function OrderHistoryDialog({
  open,
  history,
  loading,
  error,
  paymentMethods,
  onOpenChange,
  onPageChange,
  onRefresh,
}: OrderHistoryDialogProps) {
  const { t, i18n } = useTranslation('recharge');
  const totalPages = Math.max(1, Math.ceil(history.total / Math.max(1, history.pageSize)));
  const methodLabel = (paymentMethod: string, paymentProvider: string) => (
    resolvePaymentMethodLabel(paymentMethod, paymentProvider, paymentMethods, {
      alipay: t('methods.alipay'),
      wxpay: t('methods.wxpay'),
    })
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] w-[calc(100%-2rem)] max-w-5xl flex-col overflow-hidden rounded-lg border border-black/10 bg-surface-modal p-0 shadow-2xl dark:border-white/10">
        <header className="flex items-start justify-between gap-4 border-b border-black/10 px-6 py-5 dark:border-white/10">
          <div>
            <DialogTitle className="font-serif text-xl font-normal tracking-tight text-foreground">
              {t('orders.title')}
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm text-muted-foreground">
              {t('orders.description')}
            </DialogDescription>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={t('orders.refresh')}
              title={t('orders.refresh')}
              disabled={loading}
              onClick={onRefresh}
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={t('checkout.close')}
              title={t('checkout.close')}
              onClick={() => onOpenChange(false)}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </header>

        <div className="min-h-72 flex-1 overflow-auto p-5">
          {error && (
            <div className="mb-4 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          )}

          {loading && history.items.length === 0 ? (
            <div className="flex min-h-64 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              {t('loading')}
            </div>
          ) : history.items.length === 0 ? (
            <div className="flex min-h-64 items-center justify-center rounded-md border border-dashed border-black/10 text-sm text-muted-foreground dark:border-white/10">
              {t('orders.empty')}
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-black/10 dark:border-white/10">
              <div className="hidden grid-cols-[1.25fr_0.65fr_0.7fr_0.7fr_0.8fr_1fr] gap-3 border-b border-black/10 bg-black/[0.03] px-4 py-3 text-xs font-medium text-muted-foreground dark:border-white/10 dark:bg-white/[0.04] md:grid">
                <span>{t('orders.orderNumber')}</span>
                <span>{t('orders.status')}</span>
                <span>{t('orders.amount')}</span>
                <span>{t('orders.quota')}</span>
                <span>{t('orders.method')}</span>
                <span>{t('orders.date')}</span>
              </div>
              {history.items.map((order) => (
                <article
                  key={order.tradeNo}
                  className="grid gap-3 border-b border-black/10 px-4 py-4 text-sm last:border-b-0 dark:border-white/10 md:grid-cols-[1.25fr_0.65fr_0.7fr_0.7fr_0.8fr_1fr] md:items-center"
                >
                  <div className="min-w-0">
                    <p className="mb-1 text-xs text-muted-foreground md:hidden">{t('orders.orderNumber')}</p>
                    <code className="block truncate text-xs text-foreground" title={order.tradeNo}>
                      {order.tradeNo}
                    </code>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground md:hidden">{t('orders.status')}</p>
                    <span className={cn('font-medium', paymentStatusTone(order.status))}>
                      {t(`status.${order.status}`)}
                    </span>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground md:hidden">{t('orders.amount')}</p>
                    <span className="font-medium text-foreground">
                      {formatCurrency(order.amountYuan, i18n.language)}
                    </span>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground md:hidden">{t('orders.quota')}</p>
                    <span className="text-foreground">
                      {formatNumber(order.creditQuota, i18n.language, 0)}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="mb-1 text-xs text-muted-foreground md:hidden">{t('orders.method')}</p>
                    <span className="block truncate text-muted-foreground">
                      {methodLabel(order.paymentMethod, order.paymentProvider)}
                    </span>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground md:hidden">{t('orders.date')}</p>
                    <span className="block text-muted-foreground">
                      {formatDateTime(order.createdAt, i18n.language)}
                    </span>
                    {order.status === 'success' && order.completedAt && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {t('orders.completed')} {formatDateTime(order.completedAt, i18n.language)}
                      </span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-black/10 px-6 py-4 dark:border-white/10">
          <div className="text-sm text-muted-foreground">
            <span className="block">{t('orders.total', { total: history.total })}</span>
            <span className="block text-xs">{t('orders.page', { page: history.page, total: totalPages })}</span>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || history.page <= 1}
              onClick={() => onPageChange(history.page - 1)}
            >
              <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" />
              {t('orders.previous')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || history.page >= totalPages}
              onClick={() => onPageChange(history.page + 1)}
            >
              {t('orders.next')}
              <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
